import type { Context } from 'cordis';

declare module 'cordis' {
  interface Events<C extends Context = Context> {
    'app/ready': () => Promise<any> | any;
  }
}
