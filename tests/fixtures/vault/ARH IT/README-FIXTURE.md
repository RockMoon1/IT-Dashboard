This folder is a SYNTHETIC stand-in for the ARH IT vault, used by tests and by the CI smoke run
of scripts/Inspect-Vault.ps1. It contains no real ARH data. The note shapes (headings, task style,
newest-first work log, the Asset Inventory computers table, CRLF in the hub) follow the read-only
inspection of the real vault on 2026-10-15; the text is invented. Point tests at a sanitised copy
of the real vault with ARH_VAULT_FIXTURE instead of committing real notes.
