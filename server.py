from flask import Flask, send_from_directory
import socket

app = Flask(__name__, static_folder='.')

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_file(path):
    return send_from_directory('.', path)

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()
    return IP

if __name__ == '__main__':
    ip = get_local_ip()
    print("="*60)
    print(" PHOSPHOR DECAY AR ACTIVE ")
    print(f" Navigate to: https://{ip}:5000 in Quest 3 Browser")
    print("="*60)
    app.run(host='0.0.0.0', port=5000, ssl_context='adhoc')
