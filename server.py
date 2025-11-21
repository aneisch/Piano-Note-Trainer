from flask import Flask, send_from_directory
from flask_sock import Sock
import json
import logging

# Basic configuration
app = Flask(__name__, static_url_path='/', static_folder='static')
sock = Sock(app)
app.logger.setLevel(logging.INFO)

# Global state to manage the host and connected clients
HOST_SOCKET = None
CLIENT_SOCKETS = set()
GAME_STATE = {} # Global Initialization

# --- Flask Routes (Serving Static Files) ---

@app.route('/')
def serve_index():
    """Serves the main HTML page."""
    return send_from_directory('static', 'index.html')

@app.route('/<path:path>')
def serve_static_files(path):
    """Serves CSS and JS files."""
    return send_from_directory('static', path)

# --- WebSocket Logic ---

@sock.route('/ws')
def ws_handler(ws):
    """Handles all incoming WebSocket connections."""
    # CRITICAL FIX: Declare global variables to prevent UnboundLocalError
    global HOST_SOCKET
    global GAME_STATE 
    
    # Read the first message to determine the role
    initial_msg = ws.receive()
    if not initial_msg:
        return

    role = None 
    
    try:
        data = json.loads(initial_msg)
        role = data.get("role") 
    except (json.JSONDecodeError, AttributeError):
        app.logger.warning("Invalid initial message format.")
        return 

    if role not in ["host", "client"]:
        app.logger.warning(f"Received invalid role: {role}. Disconnecting.")
        return

    # 1. Host Connection
    if role == "host":
        if HOST_SOCKET:
            app.logger.warning("Attempted to connect a second host.")
            ws.send(json.dumps({"type": "ERROR", "message": "HostAlreadyExists"}))
            return

        HOST_SOCKET = ws
        app.logger.info("Host connected.")
        
        # Main Host Loop
        while True:
            try:
                message = HOST_SOCKET.receive()
                if not message:
                    break 

                # Assignment now correctly updates the global GAME_STATE
                GAME_STATE = json.loads(message) 
                
                # Broadcast state to all connected clients
                for client in list(CLIENT_SOCKETS):
                    try:
                        client.send(message) 
                    except Exception:
                        if client in CLIENT_SOCKETS: CLIENT_SOCKETS.remove(client)
                        app.logger.info("Client disconnected during broadcast.")
                        
            except Exception as e:
                app.logger.error(f"Host error: {e}")
                break

        # Cleanup when host disconnects
        HOST_SOCKET = None
        GAME_STATE = {}
        app.logger.info("Host disconnected. Game state reset.")
        for client in list(CLIENT_SOCKETS):
            try:
                client.send(json.dumps({"type": "HOST_DISCONNECTED"}))
            except Exception:
                 if client in CLIENT_SOCKETS: CLIENT_SOCKETS.remove(client)

    # 2. Client Connection
    elif role == "client":
        CLIENT_SOCKETS.add(ws)
        app.logger.info("Client connected.")
        
        # Read access to GAME_STATE is now safe
        if HOST_SOCKET and GAME_STATE: 
            try:
                ws.send(json.dumps(GAME_STATE))
            except Exception:
                app.logger.warning("Failed to send initial state to new client.")
        
        # This blocking call is safe due to Gevent workers
        try:
            while ws.receive(): 
                pass
        except Exception:
            pass
        
        if ws in CLIENT_SOCKETS:
            CLIENT_SOCKETS.remove(ws)
            app.logger.info("Client disconnected.")