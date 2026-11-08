# Ragnos HUD

Panel lateral para Claude Code, con estética cyberpunk y los colores del tema activo, que muestra de un vistazo cómo vas con tus límites de uso.

- **Límites:** barras de uso de las ventanas de 5 h y 7 días, con un marcador `┃` del tiempo transcurrido para saber si vas por delante (▲) o por detrás (▼) del ritmo esperado, y cuánto falta para cada reinicio.
- **Ventana 5H:** peticiones, tokens, sparkline de actividad cada 15 min y un pulso animado.
- **Sesión y caché:** peticiones, tokens, tiempo que la caché sigue caliente (5 m o 1 h), tokens leídos y escritos, y el % de aciertos de caché de toda la sesión.
- **Aciertos:** si sobra alto en la terminal, un tanque animado con el % de aciertos promedio de las últimas peticiones de la sesión.

Las barras de límites vienen de la API y reflejan tu cuenta completa. Las cifras de ventana 5H, sesión y caché salen de los logs locales en `~/.claude/projects/`, así que solo cuentan el uso en ese equipo. Nada sale de tu equipo.

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

### Actualizar

Si ya lo tienes instalado, en el prompt de una sesión de Claude Code en la terminal:

```
/plugin marketplace update ragnos-hud
/plugin manage
```

El primero trae la versión nueva del marketplace; el segundo abre la pestaña **Installed**, donde eliges `ragnos-hud` para actualizarlo. Luego ejecuta `/reload-plugins`.

Desde una shell:

```
claude plugin marketplace update ragnos-hud
claude plugin update ragnos-hud@ragnos-hud
```

La nueva versión se carga en la siguiente sesión, o al instante con `/reload-plugins` en una sesión abierta.

## Uso

El panel se abre solo al empezar una sesión en terminales anchas. Si no aparece, ábrelo con `/ragnos`.

Si la terminal es baja, el panel pasa a **modo compacto** y muestra solo los límites y lo esencial de la caché. Si sobra alto, aparece el tanque de aciertos, que crece con el espacio disponible.

## Limitaciones

- Los logs de más de 4 MiB no se pueden leer y se omiten (el panel lo indica). Si el omitido es el de la sesión actual, las cifras de sesión y caché quedan en cero.
- Las barras de límites solo aparecen cuando Claude Code ya ha recibido esos datos de la API.
