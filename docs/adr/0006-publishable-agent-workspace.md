# Publishable agent workspace

**Status:** Accepted

This repository will use a workspace coordinator with four independently publishable packages: server, client, agents, and shared contracts. The agents package contains agent implementations rather than an authoring SDK; its initial contents include Deep Research and Simple Chat. The client package owns the SDK for consumers of the server, while the agent-authoring contract is provided by the server package. Shared public API types and schemas live in the contracts package, consumed by both server and client. The server catalog will support both relative module paths for monorepo development and package-export references for deployments that install published agent packages, so neither workflow is mandatory. The published server and client packages provide `agent-server` and `agent-cli` executables respectively; root scripts coordinate monorepo development and are not the deployed-package interface.
