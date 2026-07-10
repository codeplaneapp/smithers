# Fix multiplayer ticket kind defaults and tombstones

GitHub: https://github.com/smithersai/smithers/issues/902

Make the multiplayer tickets collection match ListTicketsRequest semantics: omitted kind must list every kind, explicit kind must filter that kind, and soft-deleted docs must never appear. Add tests for omitted and explicit kinds and for deleted ticket rows.
