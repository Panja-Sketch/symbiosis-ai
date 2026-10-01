"use client";

import { usePathname } from "next/navigation";

export type NavItem = { readonly href: string; readonly label: string };

/** The only client component: it marks the current section (aria-current) from the URL. */
export function NavLinks({ items }: { readonly items: readonly NavItem[] }) {
  const pathname = usePathname() ?? "";
  // The most specific match wins, so "/operations" is not "current" on "/operations/evidence".
  const current = [...items]
    .sort((a, b) => b.href.length - a.href.length)
    .find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))?.href;
  return (
    <ul className="nav-list">
      {items.map((i) => (
        <li key={i.href}>
          <a href={i.href} {...(current === i.href ? { "aria-current": "page" as const } : {})}>
            {i.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Remembers the current path so switching identity can bring a colleague back to the same page. */
export function ReturnToField() {
  const pathname = usePathname() ?? "";
  return pathname === "" ? null : <input type="hidden" name="returnTo" value={pathname} />;
}
