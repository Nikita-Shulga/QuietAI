# Security policy

Quiet AI runs on your computer, reads agent activity, edits Claude Code's `settings.json` (only when you click **Connect**), downloads its own updates and can shut your computer down. Security reports matter.

## Supported versions

Only the [latest release](https://github.com/Nikita-Shulga/QuietAI/releases/latest) gets fixes. The in-app updater (Settings → About → Update now) installs it.

## Reporting a vulnerability

Please report it **privately**:

- through GitHub: **[Security → Report a vulnerability](https://github.com/Nikita-Shulga/QuietAI/security/advisories/new)**, or
- through the contact details at [nikitashulga.com](https://nikitashulga.com).

Don't open a public issue. Please include:

- what an attacker could do, and what they'd need first (local access, a crafted file, a malicious release…);
- steps to reproduce, and the Quiet AI version and OS;
- whether it's already public anywhere.

You'll get an acknowledgement within a week. Once a fix is released, you'll be credited in the changelog if you'd like.

## Things that are in scope

- The updater: release lookup, download, checksum verification and file swap.
- The Claude Code hook installer and collector.
- Anything that could trigger a power action that the user didn't arm.
- The renderer sandbox and the main-process command handling.
