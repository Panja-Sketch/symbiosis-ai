import Link from "next/link";

export default function NotFound() {
  return (
    <div className="empty" role="alert">
      <h1>Page not found</h1>
      <p>That page does not exist in this demo.</p>
      <p>
        <Link className="btn" href="/">
          Back to the start
        </Link>
      </p>
    </div>
  );
}
