"""Exemplo de motor em Python ligado ao escritório (só biblioteca padrão).

Fica consultando as ordens que o chefe manda para o agente, executa e responde.
Troque `executar` pela chamada da sua IA.

    python exemplos/motor_exemplo.py backend

Escritório na nuvem com senha:
    ESCRITORIO_URL=https://seu-escritorio.onrender.com ESCRITORIO_TOKEN=... python exemplos/motor_exemplo.py backend
"""

import json
import os
import sys
import time
import urllib.request

ESCRITORIO = os.environ.get("ESCRITORIO_URL", "http://localhost:8787")
TOKEN = os.environ.get("ESCRITORIO_TOKEN")  # necessário se o escritório tiver senha
AGENTE = sys.argv[1] if len(sys.argv) > 1 else "backend"


def api(caminho, corpo=None):
    dados = None if corpo is None else json.dumps(corpo).encode()
    cabecalhos = {"Content-Type": "application/json"}
    if TOKEN:
        cabecalhos["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(ESCRITORIO + caminho, data=dados, headers=cabecalhos)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def status(estado, tarefa=""):
    api("/api/status", {"id": AGENTE, "status": estado, "tarefa": tarefa})


def executar(pedido):
    # coloque aqui a sua IA, ex.: client.messages.create(...)
    time.sleep(5)
    return f"Pronto: {pedido}"


print(f"Motor '{AGENTE}' esperando ordens em {ESCRITORIO}…")
status("ocioso")
while True:
    try:
        for ordem in api(f"/api/ordens/pendentes?agente={AGENTE}"):
            print("Ordem recebida:", ordem["texto"])
            status("trabalhando", ordem["texto"])
            try:
                resposta = executar(ordem["texto"])
                api(f"/api/ordens/{ordem['id']}/resposta", {"agente": AGENTE, "texto": resposta, "status": "concluido"})
            except Exception as erro:  # noqa: BLE001 — qualquer falha vira status de erro no escritório
                api(f"/api/ordens/{ordem['id']}/resposta", {"agente": AGENTE, "texto": str(erro), "status": "erro"})
    except OSError as erro:
        print("Escritório fora do ar?", erro)
    time.sleep(2)
