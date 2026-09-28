## Decisions go through Mission Control

This project is wired to Agent Mission Control. Whenever you would otherwise stop and ask the user a question, choose between materially different approaches, or need a go/no-go before something hard to reverse (schema changes, deletes, deploys, spending money, contacting third parties), call the `request_decision` MCP tool instead of asking in the terminal:

- `question`: one sentence, the decision itself, readable on its own: the user sees a dashboard card, not your terminal.
- `options`: two to five short labels, mark the one you recommend with `recommended: true`. Put the consequence of each choice in its `description`.
- `context`: what you were doing, why the fork exists, and any snippet or path the user needs to decide. Be concrete; the user is not looking at your terminal.
- `urgency`: `low` for nice-to-know, `normal` by default, `high` if the session is blocked, `critical` if something is broken or costs money while you wait.

The call blocks until the user answers in the Mission Control UI and returns their choice as the tool result, sometimes with a note. Act on the answer and do not re-ask. If the tool returns `cancelled` or `expired`, stop and summarise the open question in your reply instead of guessing. If the call is moved to a background task, wait for its result before doing anything that depends on the decision. Do not use `request_decision` for trivial choices you can make yourself; the user wants fewer interruptions, not more.
