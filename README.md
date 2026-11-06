# Ragnos HUD

Panel lateral para Claude Code, con estética cyberpunk y los colores del tema activo, que muestra de un vistazo cómo vas con tus límites de uso.

- **Límites:** barras de uso de las ventanas de 5 h y 7 días, con un marcador `┃` del tiempo transcurrido para saber si vas por delante (▲) o por detrás (▼) del ritmo esperado, y cuánto falta para cada reinicio.
- **Ventana 5H / Semana 7D:** peticiones, tokens, sparkline de actividad cada 15 min y un pulso animado.
- **Sesión y caché:** peticiones, tokens, tiempo que la caché sigue caliente (5 m o 1 h), tokens leídos y escritos, y un tanque animado con el % de aciertos de caché.

Los datos salen de la sesión actual y de los logs locales en `~/.claude/projects/`. Nada sale de tu equipo.

## Instalación

En el prompt de una sesión de Claude Code en la terminal:

```
/plugin install ragnos-hud --marketplace cgarciagl/ragnos-hud
```

Responde `y` para añadir el marketplace y elige el ámbito (el de usuario es el primero).

Desde una shell:

```
claude plugin install ragnos-hud --marketplace cgarciagl/ragnos-hud
```

En la app de escritorio: pulsa + junto al cuadro del prompt, luego Plugins, Add marketplace con `cgarciagl/ragnos-hud` y después Add plugin.

## Uso

El panel se abre solo al empezar una sesión en terminales anchas. Si no aparece, ábrelo con `/ragnos`.

## Limitaciones

- Los logs de más de 4 MiB no se pueden leer y se omiten (el panel lo indica).
- Las barras de límites solo aparecen cuando Claude Code ya ha recibido esos datos de la API.
