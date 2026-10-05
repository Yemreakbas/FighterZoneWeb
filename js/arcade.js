// Arcade ("TURNUVA") progression: beat every other fighter in a row, each
// stage one difficulty level harder. Pure logic, no DOM: main.js runs the
// matches and shows the texts returned here.
//
// Result titles go to the pixel font, which has no Turkish-only glyphs.

/**
 * `myChar` is the player's fighter; `characters` the roster (for names);
 * `levels` the bot difficulties; `shuffle` orders the opponents (injectable
 * for tests).
 */
export function createArcade(myChar, characters, levels, shuffle = (a) => a) {
  const ladder = shuffle(characters.map((_, i) => i).filter((i) => i !== myChar));
  let stage = 0;
  let lastWon = false;
  let done = false;

  return {
    get ladder() { return ladder; },
    get stage() { return stage; },
    get done() { return done; },
    /** Opponent and bot difficulty (index into `levels`) for the current stage. */
    current() {
      return { opponent: ladder[stage], level: Math.min(stage, levels.length - 1) };
    },
    /**
     * Record the finished match (`won` by the player) and return the result
     * screen: { title, detail, button, cleared } where `cleared` is the number
     * of stages beaten in this run.
     */
    finish(won) {
      lastWon = won;
      const name = (i) => characters[i].name;
      if (!won) {
        return { title: 'YENILDIN', detail: `Aşama ${stage + 1}/${ladder.length} · ${name(ladder[stage])} kazandı`, button: 'TEKRAR DENE', cleared: stage };
      }
      const cleared = stage + 1;
      if (cleared >= ladder.length) {
        done = true;
        return { title: 'SAMPIYON!', detail: `${name(myChar)} turnuvayı kazandı`, button: 'YENİ TURNUVA', cleared };
      }
      return { title: `ASAMA ${cleared} TAMAM`, detail: `Sıradaki rakip: ${name(ladder[cleared])}`, button: 'SONRAKİ RAKİP', cleared };
    },
    /** After the result screen: advance on a win, stay to retry on a loss. */
    advance() {
      if (lastWon && !done) stage++;
    },
  };
}
