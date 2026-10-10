# Getting help

**Something doesn't work?** First check [docs/DETECTION.md](docs/DETECTION.md), which explains exactly what Quiet AI watches and its known limits, and the [FAQ in the README](README.md#faq).

**Still stuck?** [Open a bug report](https://github.com/Nikita-Shulga/QuietAI/issues/new?template=bug_report.yml). The most useful thing to include is the status summary: Settings → About → **Copy status summary**. It contains no chat names or private paths.

If a plan didn't fire (or fired too early), the activity log shows what it was waiting for each minute:

- Windows: `%LOCALAPPDATA%\CodexQuietShutdown\quietai-activity.log`
- macOS: `~/Library/Application Support/Quiet AI/monitor/quietai-activity.log`

It contains phases, counts and timestamps, never chat content. Still, please look it over before you share it.

**Have an idea?** [Suggest a feature](https://github.com/Nikita-Shulga/QuietAI/issues/new?template=feature_request.yml).

**Found a security problem?** Don't open a public issue. See [SECURITY.md](SECURITY.md).

Quiet AI is maintained in spare time, so replies can take a few days.
