# Troubleshooting

Diagnosticar una capa por vez:

1. Telnyx webhook y firma;
2. tenant routing y caller-security;
3. bootstrap/credencial;
4. binding del Worker y tag Cloud Run;
5. upgrade WSS y frame `start`;
6. conexión Gemini Live;
7. tool authorization y handler;
8. persistencia/auditoría.

No tocar audio, VAD, codecs, resampling o buffers para corregir un error de
control sin evidencia causal. No crear un segundo deploy como workaround.

Para llamadas mudas, correlacionar `call_id` en Worker, Cloud Run, Supabase y
Telnyx. Distinguir siempre si el flujo llegó al Worker, al Media Edge, a Gemini,
al handler y al efecto externo.
