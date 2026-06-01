/* ===================================================================
   Panneau Tweaks — réglages présentationnels (couleur, densité, etc.)
   Pilote des variables CSS sur :root, lues par toute l'application.
   =================================================================== */
const { useState, useEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#0e7c86",
  "density": "regular",
  "baseSize": 14,
  "leftWidth": 400,
  "rightWidth": 412,
  "dark": false
}/*EDITMODE-END*/;

const DENSITY = {
  compact: { row: 26, pad: 10, base: -1 },
  regular: { row: 30, pad: 14, base: 0 },
  comfy:   { row: 36, pad: 18, base: 1 },
};

function TweaksApp() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // synchroniser l'état "dark" initial avec le thème courant (bouton topbar)
  useEffect(() => {
    const cur = document.documentElement.getAttribute("data-theme");
    if ((cur === "dark") !== t.dark) setTweak("dark", cur === "dark");
    const obs = new MutationObserver(() => {
      const d = document.documentElement.getAttribute("data-theme") === "dark";
      setTweak("dark", d);
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
    // eslint-disable-next-line
  }, []);

  // appliquer les variables CSS
  useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty("--accent", t.accent);
    const d = DENSITY[t.density] || DENSITY.regular;
    r.setProperty("--density-row", d.row + "px");
    r.setProperty("--density-pad", d.pad + "px");
    document.body.style.fontSize = (t.baseSize + d.base) + "px";
    r.setProperty("--panel-left", t.leftWidth + "px");
    r.setProperty("--panel-right", t.rightWidth + "px");
  }, [t.accent, t.density, t.baseSize, t.leftWidth, t.rightWidth]);

  useEffect(() => {
    if (window.SMT) window.SMT.applyTheme(t.dark ? "dark" : "light");
  }, [t.dark]);

  return (
    <TweaksPanel>
      <TweakSection label="Apparence" />
      <TweakColor label="Couleur d’accent" value={t.accent}
        options={["#0e7c86", "#2563eb", "#6d5ae0", "#b8336a", "#0e9384"]}
        onChange={(v) => setTweak("accent", v)} />
      <TweakToggle label="Thème sombre" value={t.dark}
        onChange={(v) => setTweak("dark", v)} />

      <TweakSection label="Densité & lisibilité" />
      <TweakRadio label="Densité" value={t.density}
        options={["compact", "regular", "comfy"]}
        onChange={(v) => setTweak("density", v)} />
      <TweakSlider label="Taille du texte" value={t.baseSize} min={13} max={17} step={1} unit="px"
        onChange={(v) => setTweak("baseSize", v)} />

      <TweakSection label="Disposition" />
      <TweakSlider label="Largeur · arbre" value={t.leftWidth} min={300} max={540} step={4} unit="px"
        onChange={(v) => setTweak("leftWidth", v)} />
      <TweakSlider label="Largeur · détail" value={t.rightWidth} min={340} max={520} step={4} unit="px"
        onChange={(v) => setTweak("rightWidth", v)} />
    </TweaksPanel>
  );
}

ReactDOM.createRoot(document.getElementById("tweaks-root")).render(<TweaksApp />);
