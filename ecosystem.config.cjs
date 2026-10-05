// Para deixar rodando 24h no seu computador ou num VPS com PM2:
//   npm install            (dependências do escritório)
//   npm install -g pm2
//   ESCRITORIO_SENHA=troque-esta-senha pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup     (volta sozinho quando a máquina reinicia)
module.exports = {
  apps: [{
    name: 'agentscrets',
    script: 'servidor.js',
    autorestart: true,          // reinicia se cair
    max_restarts: 50,
    restart_delay: 2000,
    env: {
      PORTA: 8787,
      // HOST: '0.0.0.0',        // descomente para acessar de outros aparelhos (exige ESCRITORIO_SENHA)
    },
  }],
};
