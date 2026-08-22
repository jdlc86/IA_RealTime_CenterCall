const HANDOFF_CONTEXT_START = "[CONTEXTO_ACTIVO_TRANSFERENCIA]";
const HANDOFF_CONTEXT_END = "[/CONTEXTO_ACTIVO_TRANSFERENCIA]";

function stripHandoffConversationContext(instructions: string): string {
  const start = instructions.indexOf(HANDOFF_CONTEXT_START);
  if (start < 0) return instructions.trimEnd();
  const end = instructions.indexOf(HANDOFF_CONTEXT_END, start);
  if (end < 0) return instructions.slice(0, start).trimEnd();
  return `${instructions.slice(0, start)}${instructions.slice(end + HANDOFF_CONTEXT_END.length)}`.trimEnd();
}

/**
 * Adds ephemeral conversational state to the model policy. The state, rather
 * than a catalogue of caller phrases, lets the model interpret the next turn
 * relative to the transfer offer it just made.
 */
export function withHandoffConversationContext(instructions: string, offerPending: boolean): string {
  const base = stripHandoffConversationContext(instructions);
  if (!offerPending) return base;
  return `${base}\n\n${HANDOFF_CONTEXT_START}\nHay una oferta de transferencia pendiente que tú acabas de formular. Interpreta el próximo turno inteligible respecto de esa oferta. Una pregunta, objeción, duda o petición de explicación sobre la transferencia está claramente dirigida a ti: usa restaurant_conversation, responde a su significado y conserva la oferta pendiente mientras el usuario no la acepte, la rechace o cambie realmente de gestión. Usa restaurant_human_assistance únicamente si el usuario autoriza o solicita la transferencia. Usa restaurant_input_ignored solo si el contenido es claramente externo, de fondo o no dirigido a ti; la mera incertidumbre sobre una respuesta contextual no autoriza guardar silencio.\n${HANDOFF_CONTEXT_END}`;
}
