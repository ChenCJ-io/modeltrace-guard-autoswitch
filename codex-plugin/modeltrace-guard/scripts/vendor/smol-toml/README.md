# Vendored smol-toml

Parsing modules of [smol-toml](https://github.com/squirrelchat/smol-toml) 1.9.1 (BSD-3-Clause, see `LICENSE`), copied unmodified from the npm package `dist/` directory (`npm pack smol-toml@1.9.1`, sha1 `1262834a084c3ce2985900450956a580f95cf243`). Only the files needed by `parse()` are included; `stringify` and the package entry point are omitted.

The plugin uses it to read the `config.toml` stored in a CCSwitch Codex card, so a direct relay route sends the card's key only to that card's own `base_url`. Update by repeating the copy from a reviewed release and recording its version and checksum here.
