---
'@botmesh/core': patch
---

`botmesh dev` accepts `--env-file-if-exists <path>`, the optional variant of `--env-file`: it loads the file when present and stays silent when it is missing, instead of exiting with an error.
