/* Off-main-thread LUT baker. */
import { bakeLattice } from './look.js';
import { toDisplay, isLogSpace } from './color.js';

self.onmessage = (event) => {
  const { jobId, look, adjust, size, space } = event.data;
  try {
    const decode = isLogSpace(space) ? (rgb) => toDisplay(rgb, space) : null;
    let lastPost = 0;
    const values = bakeLattice(look, adjust, size, decode, (progress) => {
      const now = Date.now();
      if (now - lastPost > 90) {
        lastPost = now;
        self.postMessage({ jobId, progress });
      }
    });
    self.postMessage({ jobId, done: true, size, values }, [values.buffer]);
  } catch (error) {
    self.postMessage({ jobId, error: error.message || String(error) });
  }
};
