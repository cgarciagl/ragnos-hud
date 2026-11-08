# Instrucciones para agentes

## Versión en cada commit

En **cada commit**, sube `version` en `.claude-plugin/plugin.json` en ese mismo commit. `claude plugin update` solo compara ese número: si no cambia, los usuarios no reciben la actualización.

Usa versionado semántico (`MAYOR.MENOR.PARCHE`):

- **PARCHE** (0.2.0 → 0.2.1): correcciones, ajustes visuales menores, documentación.
- **MENOR** (0.2.1 → 0.3.0): funciones nuevas (secciones, animaciones, comandos).
- **MAYOR** (0.3.0 → 1.0.0): cambios incompatibles (por ejemplo, el formato del estado guardado).

Si cambias la forma de `Stats` en `types/index.d.ts`, sube también el `shape` del atom `stats` en `hooks/register.tsx` (por ejemplo, `stats-6` → `stats-7`).

## Antes de hacer commit

- Comprueba que `hooks/register.tsx` compila, por ejemplo con `npx esbuild hooks/register.tsx --loader:.tsx=tsx --jsx=preserve > /dev/null`.
- Cada línea del panel debe medir exactamente 30 columnas (`SIDEBAR_W`).
- Si cambias lo que muestra el panel o cómo se instala, actualiza el `README.md`.
