# Bring-your-own key for both SpaceTraders and the LLM co-pilot

Every tenant supplies and stores their own SpaceTraders agent token and
their own LLM API key; the app never holds a shared credential it spends on
a tenant's behalf. This closes the abuse vector a shared co-pilot key would
open (one tenant's chat usage spending another operator's bill) without
needing usage metering, quotas, or a billing layer. Both secrets are
encrypted at rest (AES-256-GCM) off one `SESSION_SECRET`-derived key
(`src/auth/crypto.ts`) and never sent back to the client after save. There
is deliberately no global on/off flag for the co-pilot: the absence of a
stored `llm_key_enc` for a tenant *is* "off" for that tenant. `ChatLLM`
already spoke an OpenAI-compatible chat-completions shape (`{ apiKey,
model, baseUrl }`, defaulting to Ollama Cloud) before this app existed, so
no adapter layer was needed to carry the setting through — only the
storage and settings-page plumbing around it (the settings-page HTTP route
itself remains unbuilt as of this writing; see README's Phase C notes).
Anthropic is out of scope natively (it doesn't speak the same
chat-completions shape) but reachable through OpenRouter if a tenant wants
Claude specifically.
