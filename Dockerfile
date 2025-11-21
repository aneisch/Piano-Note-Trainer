# Use a lightweight Python base image
FROM python:3.11-alpine

# Install dependencies (Flask, Flask-Sock, Gunicorn, and Gevent)
RUN apk add --no-cache gcc musl-dev linux-headers
RUN pip install flask gunicorn flask-sock gevent

# Set the working directory
WORKDIR /app

# Copy the Python backend server and the static web files
COPY server.py .
COPY index.html app.js ./static/

# Expose port 8080
EXPOSE 8080

# Command to run the application using Gunicorn with the GE asynchronous worker
# This allows concurrent handling of multiple client connections.
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--worker-class", "gevent", "--workers", "1", "server:app"]