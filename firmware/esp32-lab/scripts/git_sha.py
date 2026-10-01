"""PlatformIO pre-script: stamp the build with the Git revision (diagnostics/provenance only).

The value ends up in the firmware_version field as e.g. 0.1.0+g1a2b3c4 (or ...-dirty). It is never
used by any risk logic. Falls back to "nogit" outside a repository.
"""
import subprocess

Import("env")  # noqa: F821  (provided by PlatformIO)


def git(*args):
    try:
        return subprocess.check_output(
            ["git", *args], cwd=env.subst("$PROJECT_DIR"), stderr=subprocess.DEVNULL, text=True  # noqa: F821
        ).strip()
    except Exception:
        return ""


sha = git("rev-parse", "--short=7", "HEAD") or "nogit"
if sha != "nogit" and git("status", "--porcelain", "--", "."):
    sha += "-dirty"
env.Append(CPPDEFINES=[("SYM_GIT_SHA", env.StringifyMacro(sha))])  # noqa: F821
