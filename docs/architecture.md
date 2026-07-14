# Architecture

> Draft — expanded as `core` and the adapters are implemented (see repo roadmap in README).

See the diagram and component summary in the root [README](../README.md#architecture) for
the current high-level picture: agent adapters normalize events, the core relay owns the
approval lifecycle and routing, channel adapters render and deliver to humans.

Open decisions to be resolved while building `packages/core`:

- **CLI ↔ daemon transport.** Unix domain socket vs. loopback HTTP with a local token file.
  Loopback HTTP is more portable (Windows), a socket is simpler to permission-scope on
  Unix-likes.
- **Audit log scope.** Whether `fullContext` (raw commands/diffs) is written verbatim to the
  durable audit log, or the log stores a summary/hash while full context stays ephemeral.
