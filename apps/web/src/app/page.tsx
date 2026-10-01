import { ErrorState } from "../components/ui";
import { Landing } from "../components/Landing";
import { getDirectory, getSession } from "../lib/session";

export const metadata = { title: "Choose a demo identity" };

export default async function Home({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [directory, session, q] = await Promise.all([getDirectory(), getSession(), searchParams]);
  if (directory === undefined) {
    return (
      <ErrorState
        error={{
          ok: false,
          status: 0,
          code: "API_UNREACHABLE",
          message: "The Symbiosis API could not be reached. Start it with `pnpm dev` and reload.",
        }}
      />
    );
  }
  return (
    <>
      {q.error === "unknown-identity" && (
        <p className="notice notice-error" role="alert">
          That identity is not in the demo directory.
        </p>
      )}
      <Landing directory={directory} session={session} />
    </>
  );
}
