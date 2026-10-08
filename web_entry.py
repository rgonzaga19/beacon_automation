"""WSGI entry point for hosted deployments."""

from server import app, init_database


# Create tables on first boot. Keep this lightweight until proper migrations
# are introduced; subsequent schema changes should use Alembic migrations.
init_database()
