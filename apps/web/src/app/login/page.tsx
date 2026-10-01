import { redirect } from "next/navigation";
import { LoginForm } from "../../components/firebase-login";
import { authMode } from "../../lib/auth-mode";

export const metadata = { title: "Sign in" };

export default function Login() {
  if (authMode() !== "token") redirect("/");
  return <LoginForm />;
}
