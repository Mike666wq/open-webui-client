# Open WebUI structure reference

Pinned upstream: `open-webui/open-webui@91ea4e3421d1d8069f13d4a463fcb5986d94ea60`.

Inspected sources:
- `src/lib/components/chat/Chat.svelte`: `#chat-container`, `#chat-pane`, `#messages-container`, chat input and background-layer structure.
- `src/lib/components/chat/Messages.svelte`: mounted messages in a conversation log; older history is loaded separately.
- `src/lib/components/chat/Messages/UserMessage.svelte`: `.user-message#message-{id}`, `.markdown-prose` / `.whitespace-pre-wrap` content.

`chat.html` is an independently written minimal structural fixture. It does not embed upstream application code, branding or assets. Actual older/newer server releases are supported only when the required structural hooks are present; this is not a promise of universal version compatibility. Unknown structures, login and administration routes are left unchanged.

For static browser review, serve a temporary copy on loopback; copy the Android asset as `adapter.js`, prefixed with `window.fixtureAdapter = `. Do not generate tracked assets. Browser visual checks are distinct from native-device validation.
