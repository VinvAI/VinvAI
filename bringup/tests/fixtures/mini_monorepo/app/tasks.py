"""Fixture celery worker/beat entry — a non-HTTP long-runner."""

from celery import Celery

celery_app = Celery("mini", broker="redis://localhost:6379/0")


@celery_app.task
def crunch(n: int) -> int:
    return n * 2
