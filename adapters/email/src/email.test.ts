import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { NotificationRequest } from "@symbiosis/contracts";
import { ManualClock } from "@symbiosis/clock";
import { StoreContactDirectory } from "@symbiosis/notifications";
import { InMemoryTenantDocumentStore } from "@symbiosis/repositories";
import { FakeEmailTransport } from "./fake";
import { EmailNotificationSender, SmtpEmailNotificationSender } from "./sender";
import { SmtpTransport, buildMimeMessage, dotStuff } from "./smtp";
import type { EmailMessage } from "./smtp";

const clock = new ManualClock(Date.parse("2026-10-02T10:00:00Z"));
const ORG = "ORG-SIM-001";

const request = (over: Partial<NotificationRequest> = {}): NotificationRequest => ({
  notificationId: "NTF-000001",
  organizationId: ORG,
  facilityId: "FAC-1",
  channel: "EMAIL",
  recipient: { ref: "USR-FACILITY-MGR-001", role: "FACILITY_MANAGER" },
  subject: "[ALERT] [HIGH] Cooling risk · Northgate",
  body: "A risk requires attention.\nOpen: https://app.example/operations/cases/CASE-1 (sign-in required)",
  caseId: "CASE-1",
  riskEventId: "RE-1",
  severity: "HIGH",
  requestedAt: "2026-10-02T10:00:00.000Z",
  kind: "INITIAL",
  ...over,
});

async function sender(contact: Partial<Parameters<StoreContactDirectory["put"]>[0]> | null = {}) {
  const contacts = new StoreContactDirectory(new InMemoryTenantDocumentStore());
  if (contact !== null) {
    await contacts.put({
      actorId: "USR-FACILITY-MGR-001",
      organizationId: ORG,
      email: "facility.manager@example.test",
      enabled: true,
      categories: ["INITIAL", "ESCALATION", "FOLLOW_UP"],
      updatedAt: "t",
      updatedBy: "u",
      ...contact,
    });
  }
  const transport = new FakeEmailTransport();
  return {
    transport,
    sender: new EmailNotificationSender({
      clock,
      contacts,
      transport,
      from: () => "alerts@example.test",
      fromName: "Symbiosis AI",
    }),
  };
}

describe("EmailNotificationSender (provider-independent decisions)", () => {
  it("sends to the address held in the contact directory, never to anything in the request", async () => {
    const { sender: s, transport } = await sender();
    const r = await s.send(request());
    expect(r).toMatchObject({
      status: "SENT",
      channel: "EMAIL",
      addressHint: "f***r@example.test",
    });
    expect(JSON.stringify(r)).not.toContain("facility.manager@");
    expect(transport.outbox).toHaveLength(1);
    expect(transport.outbox[0]).toMatchObject({
      to: "facility.manager@example.test",
      from: "alerts@example.test",
      fromName: "Symbiosis AI",
      subject: "[ALERT] [HIGH] Cooling risk · Northgate",
      messageId: "NTF-000001@symbiosis.local",
    });
  });

  it("fails permanently and clearly when the actor has no address", async () => {
    const { sender: s, transport } = await sender(null);
    expect(await s.send(request())).toMatchObject({
      status: "FAILED",
      failure: { code: "NO_RECIPIENT_ADDRESS", retryable: false },
    });
    expect(transport.attempts).toHaveLength(0);
  });

  it("does not use another organization's contact", async () => {
    const { sender: s, transport } = await sender();
    expect(await s.send(request({ organizationId: "ORG-OTHER" }))).toMatchObject({
      status: "FAILED",
    });
    expect(transport.attempts).toHaveLength(0);
  });

  it("refuses an invalid stored address instead of sending", async () => {
    const contacts = new StoreContactDirectory(new InMemoryTenantDocumentStore());
    const store = (contacts as unknown as { store: InMemoryTenantDocumentStore }).store;
    await store.put("contacts", ORG, "USR-FACILITY-MGR-001", {
      actorId: "USR-FACILITY-MGR-001",
      organizationId: ORG,
      email: "a@b.co\r\nBcc: attacker@evil.test",
      enabled: true,
      categories: ["INITIAL"],
      updatedAt: "t",
      updatedBy: "u",
    });
    const transport = new FakeEmailTransport();
    const s = new EmailNotificationSender({
      clock,
      contacts,
      transport,
      from: () => "alerts@example.test",
    });
    expect(await s.send(request())).toMatchObject({
      failure: { code: "INVALID_RECIPIENT", retryable: false },
    });
    expect(transport.attempts).toHaveLength(0);
  });

  it("honors the person's notification preferences", async () => {
    const off = await sender({ enabled: false });
    expect(await off.sender.send(request())).toMatchObject({
      failure: { code: "RECIPIENT_OPTED_OUT", retryable: false },
    });
    expect(off.transport.attempts).toHaveLength(0);

    const noFollow = await sender({ categories: ["INITIAL"] });
    expect(await noFollow.sender.send(request({ kind: "FOLLOW_UP" }))).toMatchObject({
      failure: { code: "RECIPIENT_OPTED_OUT" },
    });
    expect((await noFollow.sender.send(request({ kind: "INITIAL" }))).status).toBe("SENT");
    // the first alert of a risk is always allowed while notifications are on, whatever the categories
    const none = await sender({ categories: [] });
    expect((await none.sender.send(request({ kind: "INITIAL" }))).status).toBe("SENT");
  });

  it("classifies transport failures: transient is retryable, a refused recipient is not", async () => {
    const { sender: s, transport } = await sender();
    transport.failNext({
      ok: false,
      code: "TRANSIENT",
      message: "SMTP temporary failure (421)",
      retryable: true,
    });
    expect(await s.send(request())).toMatchObject({
      failure: { code: "TRANSIENT", retryable: true },
    });
    transport.rejectRecipient("facility.manager@example.test");
    expect(await s.send(request())).toMatchObject({
      failure: { code: "RECIPIENT_REJECTED", retryable: false },
    });
  });

  it("a transport that throws is a retryable failure, not an exception", async () => {
    const contacts = new StoreContactDirectory(new InMemoryTenantDocumentStore());
    await contacts.put({
      actorId: "USR-FACILITY-MGR-001",
      organizationId: ORG,
      email: "a@example.test",
      enabled: true,
      categories: ["INITIAL"],
      updatedAt: "t",
      updatedBy: "u",
    });
    const s = new EmailNotificationSender({
      clock,
      contacts,
      transport: {
        send: async () => {
          throw new Error("boom with secret");
        },
      },
      from: () => "alerts@example.test",
    });
    const r = await s.send(request());
    expect(r).toMatchObject({
      status: "FAILED",
      failure: { code: "TRANSPORT_ERROR", retryable: true },
    });
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});

describe("MIME building", () => {
  const msg = (over: Partial<EmailMessage> = {}): EmailMessage => ({
    from: "alerts@example.test",
    to: "a@example.test",
    subject: "Hello",
    text: "body",
    messageId: "id@symbiosis.local",
    date: new Date("2026-10-02T10:00:00Z"),
    ...over,
  });

  it("encodes the body as base64 UTF-8 and non-ASCII subjects as encoded words", () => {
    const mime = buildMimeMessage(
      msg({ subject: "Alerte · réfrigération", text: "Température élevée\nligne 2" }),
    );
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(mime).toMatch(/Content-Transfer-Encoding: base64/);
    expect(mime).toMatch(/Auto-Submitted: auto-generated/);
    expect(mime).toMatch(/Date: Fri, 02 Oct 2026 10:00:00 \+0000/);
    const body = mime.split("\r\n\r\n")[1]?.replace(/\r\n/g, "") ?? "";
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Température élevée\nligne 2");
  });

  it("refuses a header value that could inject another header", () => {
    expect(() => buildMimeMessage(msg({ subject: "x\r\nBcc: a@b.co" }))).toThrow();
    expect(() => buildMimeMessage(msg({ to: "a@b.co\nBcc: x@y.z" }))).toThrow();
    expect(() => buildMimeMessage(msg({ from: "a@b.co\r\n" }))).toThrow();
    expect(() => buildMimeMessage(msg({ extraHeaders: { "X-A": "v\r\nBcc: x" } }))).toThrow();
  });

  it("dot-stuffs lines that start with a dot", () => {
    expect(dotStuff("a\r\n.b\r\n..c\r\n")).toBe("a\r\n..b\r\n...c\r\n");
    expect(dotStuff(".first")).toBe("..first");
  });
});

/** A scriptable in-process SMTP server (loopback, plain text: tests only). */
type Script = {
  greet?: string;
  auth?: string;
  rcpt?: string;
  data?: string;
  hangAt?: "data-end";
  dropAt?: "rcpt";
};

function smtpServer(script: Script = {}) {
  const received: { user?: string; pass?: string; from?: string; to?: string; data: string } = {
    data: "",
  };
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let inData = false;
    let buffer = "";
    socket.write((script.greet ?? "220 test.local ESMTP") + "\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          received.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          if (script.hangAt === "data-end") return;
          socket.write((script.data ?? "250 2.0.0 OK queued") + "\r\n");
          continue;
        }
        const at = buffer.indexOf("\r\n");
        if (at === -1) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (line.startsWith("EHLO")) socket.write("250-test.local\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH PLAIN")) {
          const [, user, pass] = Buffer.from(line.slice(11), "base64").toString("utf8").split("\0");
          received.user = user ?? "";
          received.pass = pass ?? "";
          socket.write((script.auth ?? "235 2.7.0 Accepted") + "\r\n");
        } else if (line.startsWith("MAIL FROM:")) {
          received.from = line.slice(10);
          socket.write("250 OK\r\n");
        } else if (line.startsWith("RCPT TO:")) {
          received.to = line.slice(8);
          if (script.dropAt === "rcpt") return void socket.destroy();
          socket.write((script.rcpt ?? "250 OK") + "\r\n");
        } else if (line === "DATA") {
          inData = true;
          socket.write(
            (script.data?.startsWith("4") || script.data?.startsWith("5")
              ? script.data
              : "354 go ahead") + "\r\n",
          );
          if (script.data?.startsWith("4") || script.data?.startsWith("5")) inData = false;
        } else if (line === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("502 not implemented\r\n");
      }
    });
  });
  return new Promise<{ port: number; received: typeof received; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        resolve({
          port,
          received,
          close: () =>
            new Promise<void>((r) => {
              for (const s of sockets) s.destroy();
              server.close(() => r());
            }),
        });
      });
    },
  );
}

describe("SmtpTransport against a scripted server", () => {
  let closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.map((c) => c()));
    closers = [];
  });
  const message = (over: Partial<EmailMessage> = {}): EmailMessage => ({
    from: "alerts@example.test",
    to: "manager@example.test",
    subject: "[ALERT] test",
    text: "line one\n.\nline three",
    messageId: "NTF-1@symbiosis.local",
    date: new Date("2026-10-02T10:00:00Z"),
    ...over,
  });
  const transport = async (script: Script = {}, timeoutMs = 2000) => {
    const srv = await smtpServer(script);
    closers.push(srv.close);
    return {
      srv,
      t: new SmtpTransport(
        { host: "127.0.0.1", port: srv.port, security: "none", timeoutMs },
        async () => ({
          username: "sender@example.test",
          password: "APP-PASSWORD-VALUE",
        }),
      ),
    };
  };

  it("delivers a message: envelope, authentication and a body that survives dot-stuffing", async () => {
    const { t, srv } = await transport();
    const r = await t.send(message());
    expect(r).toEqual({ ok: true, response: "250 accepted" });
    expect(srv.received).toMatchObject({
      user: "sender@example.test",
      from: "<alerts@example.test>",
      to: "<manager@example.test>",
    });
    const body = srv.received.data.split("\r\n\r\n")[1]?.replace(/\r\n/g, "") ?? "";
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("line one\n.\nline three");
    // the password reached the server (to authenticate) but is nowhere in the message itself
    expect(srv.received.data).not.toContain("APP-PASSWORD-VALUE");
  });

  it("maps a rejected login to a permanent AUTH_FAILED without leaking the password", async () => {
    const { t } = await transport({ auth: "535 5.7.8 Username and Password not accepted" });
    const r = await t.send(message());
    expect(r).toMatchObject({ ok: false, code: "AUTH_FAILED", retryable: false });
    expect(JSON.stringify(r)).not.toContain("APP-PASSWORD-VALUE");
  });

  it("maps a refused recipient to a permanent RECIPIENT_REJECTED", async () => {
    const { t } = await transport({ rcpt: "550 5.1.1 no such user" });
    expect(await t.send(message())).toMatchObject({
      ok: false,
      code: "RECIPIENT_REJECTED",
      retryable: false,
    });
  });

  it("maps 4xx replies to a retryable TRANSIENT failure", async () => {
    expect(
      await (await transport({ greet: "421 service not available" })).t.send(message()),
    ).toMatchObject({ ok: false, code: "TRANSIENT", retryable: true });
    expect(
      await (await transport({ data: "452 4.3.1 insufficient storage" })).t.send(message()),
    ).toMatchObject({ ok: false, code: "TRANSIENT", retryable: true });
  });

  it("treats a connection dropped mid-session and an unreachable server as retryable", async () => {
    const { t } = await transport({ dropAt: "rcpt" });
    expect(await t.send(message())).toMatchObject({
      ok: false,
      code: "CONNECTION_FAILED",
      retryable: true,
    });
    const down = new SmtpTransport(
      { host: "127.0.0.1", port: 1, security: "none", timeoutMs: 500 },
      async () => ({ username: "", password: "" }),
    );
    expect(await down.send(message())).toMatchObject({ ok: false, retryable: true });
  });

  it("times out instead of hanging", async () => {
    const { t } = await transport({ hangAt: "data-end" }, 300);
    expect(await t.send(message())).toMatchObject({ ok: false, code: "TIMEOUT", retryable: true });
  });

  it("refuses to build an unsafe message before touching the network", async () => {
    const { t, srv } = await transport();
    expect(await t.send(message({ subject: "x\r\nBcc: a@b.co" }))).toMatchObject({
      ok: false,
      code: "INVALID_MESSAGE",
      retryable: false,
    });
    expect(srv.received.from).toBeUndefined();
    expect(await t.send(message({ text: "x".repeat(300_000) }))).toMatchObject({
      ok: false,
      code: "MESSAGE_TOO_LARGE",
    });
  });

  it("will not send plain text to any host except loopback", () => {
    expect(
      () =>
        new SmtpTransport({ host: "smtp.gmail.com", port: 25, security: "none" }, async () => ({
          username: "",
          password: "",
        })),
    ).toThrow(/loopback/);
  });

  it("the Smtp sender wires contacts, from-address and transport end to end", async () => {
    const srv = await smtpServer();
    closers.push(srv.close);
    const contacts = new StoreContactDirectory(new InMemoryTenantDocumentStore());
    await contacts.put({
      actorId: "USR-FACILITY-MGR-001",
      organizationId: ORG,
      email: "manager@example.test",
      enabled: true,
      categories: ["INITIAL"],
      updatedAt: "t",
      updatedBy: "u",
    });
    const s = new SmtpEmailNotificationSender({
      clock,
      contacts,
      smtp: { host: "127.0.0.1", port: srv.port, security: "none" },
      credentials: async () => ({
        username: "sender@example.test",
        password: "APP-PASSWORD-VALUE",
      }),
      from: () => "sender@example.test",
      fromName: "Symbiosis AI",
    });
    const r = await s.send(request());
    expect(r.status).toBe("SENT");
    expect(srv.received.to).toBe("<manager@example.test>");
    expect(srv.received.data).toMatch(/^From: Symbiosis AI <sender@example.test>/);
    expect(srv.received.data).toMatch(/X-Symbiosis-Case: CASE-1/);
  });
});
