# Servidor do Laya (modelo de decisão open source da Convai Innovations, Apache 2.0).
# Roda só na CPU; precisa de uns 3 GB de RAM livres. Na primeira subida ele baixa
# o modelo do Hugging Face (~2 GB), que fica guardado no volume laya-cache.
FROM python:3.12-slim
# PyTorch só para CPU: bem menor que o padrão, que vem com CUDA
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir "laya[serve]==0.3.28"
ENV LAYA_HOST=0.0.0.0 LAYA_PORT=8000 USE_TF=0 HF_HOME=/cache \
    LAYA_MODELS=multilingual LAYA_DEFAULT_MODEL=multilingual LAYA_MAX_LOADED=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
CMD ["laya-serve"]
