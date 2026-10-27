# Decisions

- 2026-02-10: A person is identified by email address, compared case-insensitively and ignoring surrounding whitespace.
- 2026-02-10: When one person signed up more than once, keep the earliest signup (smallest createdAt); it carries the original referral credit. The export keeps the input order of the records it keeps.
