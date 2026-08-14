# User-turn watchdog v18

- VAD/audio detection does not reset inactivity.
- A turn is considered valid only when Lucia reacts semantically by speaking coherently or selecting a concrete agent tool.
- Presence recovery prompts do not reset the original inactivity clock.
- Tool execution suspends only the relative user-turn watchdog.
- The absolute call duration guard remains active.
