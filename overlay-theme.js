(() => {
    function clamp01(value) {
        return Math.max(0, Math.min(1, Number(value) || 0));
    }

    function clamp255(value) {
        return Math.max(0, Math.min(255, Number(value) || 0));
    }

    function parseCssRgbTriplet(value, fallback) {
        const parts = String(value || "").split(",").map((part) => Number.parseFloat(part.trim()));
        if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
            return fallback.slice();
        }
        return parts.map((n) => clamp255(n));
    }

    function toUnit(color255a) {
        return [color255a[0] / 255, color255a[1] / 255, color255a[2] / 255, color255a[3]];
    }

    function buildCanonicalTheme({idleRgb = [44, 47, 51], idleAlpha = 0.7, alphaScale = 1}) {
        const scaledIdleAlpha = clamp01(idleAlpha * alphaScale);
        return {
            idle: [idleRgb[0], idleRgb[1], idleRgb[2], scaledIdleAlpha],
            pressed: [63, 140, 255, 1],
            black: [0, 0, 0, 1],
            borderOuter: [255, 255, 255, 1],
            borderInner: [0, 0, 0, 1],
            rightFaceUp: [95, 95, 31, scaledIdleAlpha],
            rightFaceRight: [95, 31, 31, scaledIdleAlpha],
            rightFaceLeft: [31, 31, 95, scaledIdleAlpha],
            rightFaceDown: [31, 79, 32, scaledIdleAlpha],
            rightFacePressedUp: [255, 255, 51, 1],
            rightFacePressedRight: [255, 51, 51, 1],
            rightFacePressedLeft: [51, 119, 255, 1],
            rightFacePressedDown: [63, 207, 63, 1],
        };
    }

    function buildThemeFromCss({rootStyles, alphaScale = 1}) {
        const idleRgb = parseCssRgbTriplet(rootStyles.getPropertyValue("--btn-idle-rgb"), [44, 47, 51]);
        const idleAlpha = Number.parseFloat(rootStyles.getPropertyValue("--btn-idle-alpha")) || 0.7;
        return buildCanonicalTheme({idleRgb, idleAlpha, alphaScale});
    }

    function buildThemeForCanvas2D({rootStyles}) {
        return buildThemeFromCss({rootStyles, alphaScale: 1});
    }

    function buildThemeForWebGL({rootStyles, alphaScale = 1}) {
        const canonical = buildThemeFromCss({rootStyles, alphaScale});
        const output = {};
        for (const [key, color] of Object.entries(canonical)) {
            output[key] = toUnit(color);
        }
        return output;
    }

    const CSS_DEFAULTS = Object.freeze({
        "--btn-idle-rgb": "44, 47, 51",
        "--btn-idle-alpha": "0.7",
        "--btn-idle": "rgba(44, 47, 51, 0.7)",
        "--btn-pressed": "#3f8cff",
        "--overlay-border-inner-size": "4",
        "--overlay-border-outer-size": "4",
    });

    function applyCssDefaults(element = document.documentElement) {
        const styles = getComputedStyle(element);
        for (const [name, value] of Object.entries(CSS_DEFAULTS)) {
            const existing = styles.getPropertyValue(name).trim();
            if (!existing) {
                element.style.setProperty(name, value);
            }
        }
    }

    const THEME_PRESETS = Object.freeze({
        xbox: Object.freeze({
            global: Object.freeze({}),
            "right:up": Object.freeze({"--btn-idle": "rgba(95, 95, 31, 0.7)", "--btn-pressed": "#ffff33"}),
            "right:right": Object.freeze({"--btn-idle": "rgba(95, 31, 31, 0.7)", "--btn-pressed": "#ff3333"}),
            "right:left": Object.freeze({"--btn-idle": "rgba(31, 31, 95, 0.7)", "--btn-pressed": "#3377ff"}),
            "right:down": Object.freeze({"--btn-idle": "rgba(31, 79, 32, 0.7)", "--btn-pressed": "#3fcf3f"}),
        }),
        snes: Object.freeze({
            global: Object.freeze({}),
            "right:up": Object.freeze({"--btn-idle": "rgba(32, 32, 79, 0.7)", "--btn-pressed": "#5555ff"}),
            "right:right": Object.freeze({"--btn-idle": "rgba(79, 32, 32, 0.7)", "--btn-pressed": "#ff5555"}),
            "right:down": Object.freeze({"--btn-idle": "rgba(79, 79, 32, 0.7)", "--btn-pressed": "#ffff55"}),
            "right:left": Object.freeze({"--btn-idle": "rgba(32, 79, 32, 0.7)", "--btn-pressed": "#55ff55"}),
        }),
    });

    window.OverlayTheme = Object.freeze({
        CSS_DEFAULTS,
        THEME_PRESETS,
        applyCssDefaults,
        buildThemeForCanvas2D,
        buildThemeForWebGL,
    });
})();
