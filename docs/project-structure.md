# Project Structure

This is the current package layout. `server.py` remains at the repository root
as the deployment entry point, while backend modules live under `app/`.

```text
beacon_automation/
  server.py                 Flask and Socket.IO entry point
  app/
    core/                   Configuration, database, security, settings, logging
    api/                    Beacon-facing API client modules
    automation/             CF2, SOA, CF4, and draft automation runners
    domain/                 Parsers, mappers, data objects, and reports
    models.py               Users, settings, and automation job models
  renderer/                 Browser UI served as static files
    assets/                 Images and icons used by the UI
    css/                    Shared and page-specific CSS
    js/                     Browser-side JavaScript
    *.html                  Browser pages
  templates/                Excel templates downloaded by users
  docs/                     Project notes and structure documentation
  requirements.txt          Python dependencies
  render.yaml               Render deployment configuration
  runtime.txt               Python runtime hint for deployment
```
