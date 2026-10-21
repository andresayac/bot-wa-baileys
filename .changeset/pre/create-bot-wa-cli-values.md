---
"create-bot-wa": patch
---

CLI: `--template`/`-t` and `--name` without a value (or followed by another option, as in `-t --yes`) now fail with "Option --template needs a value" instead of silently falling back to the default template. `--name @acme/support-bot` keeps its scope (it used to become `support-bot`), names are capped at npm's 214 characters, and "Next steps" lists `npm run dev` and prints an absolute `cd` path when the project is outside the current directory.
