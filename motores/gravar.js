// Gravação segura de arquivos de estado: uma por vez para cada arquivo e com
// arquivo temporário próprio (duas gravações ao mesmo tempo não se atropelam).
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const filas = new Map();
let contador = 0;

export function gravarArquivo(caminho, conteudo) {
  const escrever = async () => {
    await mkdir(dirname(caminho), { recursive: true });
    const tmp = `${caminho}.${process.pid}.${++contador}.tmp`;
    await writeFile(tmp, conteudo);
    await rename(tmp, caminho);
  };
  const atual = (filas.get(caminho) || Promise.resolve()).then(escrever, escrever);
  filas.set(caminho, atual.catch(() => {}));
  return atual;
}
