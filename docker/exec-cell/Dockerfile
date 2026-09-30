# BANTAM execution cell image: the plain Python image plus python-chess for the
# chess move-facts gauge. Packages are installed at build time; at run time the
# cell has no network (see src/factory/exec-gauge.js).
FROM python:3.13-slim-bookworm
RUN pip install --no-cache-dir chess==1.11.2
