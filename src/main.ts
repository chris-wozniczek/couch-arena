import '@fontsource/bebas-neue/400.css';
import '@fontsource-variable/inter/index.css';
import './ui/styles.css';
import { App } from './app';

const root = document.querySelector<HTMLDivElement>('#app')!;
const app = new App(root);
Object.assign(window, { couchArena: app });
void app.boot().catch((e: unknown) => {
  console.error(e);
  root.insertAdjacentHTML(
    'beforeend',
    `<div class="screen"><h2>Something went wrong</h2><div class="muted">${String((e as Error).message ?? e)}</div></div>`,
  );
});
