/** True when the main way of pointing is a finger (phones and tablets). */
export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches;

/**
 * Calls `fn` when `el` is double-tapped with a finger. Phones do not reliably send `dblclick`,
 * which stays in place for the mouse; where both arrive, the second reset changes nothing.
 */
export function onDoubleTap(el: HTMLElement, fn: () => void) {
  let downX = 0, downY = 0, lastTime = 0, lastX = 0, lastY = 0;
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { downX = e.clientX; downY = e.clientY; } });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 10) { lastTime = 0; return; } // a drag, not a tap
    if (e.timeStamp - lastTime < 350 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 30) { lastTime = 0; fn(); }
    else { lastTime = e.timeStamp; lastX = e.clientX; lastY = e.clientY; }
  });
}
