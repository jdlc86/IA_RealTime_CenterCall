# Runbook de despliegue

## Única autoridad

El sistema completo se despliega exclusivamente con:

```text
.github/workflows/gemini-fast-canary-deploy.yml
workflow: Gemini Fast Canary Deploy
rama: rebuild/v39-stable-baseline
```

No ejecutar scripts alternativos ni crear revisiones manuales para atender
llamadas. Una revisión sin tag/binding no es usada automáticamente por el Worker.

## Secuencia

1. checkout del SHA exacto;
2. instalación y pruebas;
3. build de `Dockerfile.fast`;
4. deploy etiquetado sin tráfico;
5. readiness del provider;
6. sincronización de secretos y binding del Fast Worker;
7. preflights health, semantic-security, bootstrap y WSS/HMAC;
8. retirada de tags antiguos;
9. promoción de la revisión exacta al 100 %;
10. E2E sintético sobre la URL general.

## Ejecución

GitHub Actions → `Gemini Fast Canary Deploy` → `Run workflow` → rama estable.

CLI:

```bash
gh workflow run "Gemini Fast Canary Deploy" \
  --repo jdlc86/IA_RealTime_CenterCall \
  --ref rebuild/v39-stable-baseline
```

## Etapa de pruebas y coste

El workflow aplica la configuración declarada de producción. Si se autoriza
explícitamente reducir el mínimo durante pruebas, puede ajustarse Cloud Run a
`min-instances=0`; el siguiente deploy integral podrá restablecerla.

## Verificación

Comprobar SHA, revisión, tag, tráfico general, binding
`GEMINI_FAST_CANARY_EDGE_URL`, health del Worker y `/ready`. No hacer una
llamada real sin autorización.
