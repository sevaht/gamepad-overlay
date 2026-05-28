(() => {
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

    window.OverlayTheme = Object.freeze({
        CSS_DEFAULTS,
        applyCssDefaults,
    });
})();

(() => {
    const DEFAULTS = Object.freeze({
        buttonLength: 132,
        buttonWidth: 132,
        gap: 1,
        betweenHalvesGap: 0,
        digitalThreshold: 0.55,
        topLeftX: 0,
        topLeftY: 0,
        wsPort: 8765,
        pollHz: 240,
    });

    function parseInputSource(query) {
        const source = (query.get("source") || "websocket").toLowerCase();
        if (source === "ws") {
            return "websocket";
        }
        return ["browser", "websocket", "demo"].includes(source)
            ? source
            : "browser";
    }

    function queryNumber(query, key, fallback) {
        const value = Number.parseFloat(query.get(key) || "");
        return Number.isFinite(value) ? value : fallback;
    }

    function queryInt(query, key, fallback) {
        const value = Number.parseInt(query.get(key) || "", 10);
        return Number.isFinite(value) ? value : fallback;
    }

    function createSource({query, mode, renderer, onStatus = () => {}}) {
        const pollHz = Math.max(1, queryInt(query, "pollHz", DEFAULTS.pollHz));
        return createGamepadSource({
            mode,
            wsUrl: `ws://${query.get("wsHost") || "localhost"}:${DEFAULTS.wsPort}/gamepad-overlay`,
            pollMs: Math.max(1, Math.round(1000 / pollHz)),
            padIndex:
                query.get("padIndex") == null
                    ? null
                    : Math.max(0, Number.parseInt(query.get("padIndex"), 10) || 0),
            padIdContains: (query.get("padIdContains") || "").trim(),
            padRequireStandard: query.get("padAllowAll") !== "1",
            onState: (state) => renderer.applyState(state),
            onStatus,
        });
    }

    function sanitizeProfileName(value) {
        const normalized = String(value || "").trim().toLowerCase();
        if (!normalized) {
            return null;
        }
        return /^[a-z0-9_-]+$/.test(normalized) ? normalized : null;
    }

    function sanitizeThemeName(themeName) {
        const value = sanitizeProfileName(themeName);
        if (!value) {
            return null;
        }
        return value;
    }

    function attachThemeStylesheet(themeName) {
        const existing = document.getElementById("overlay-theme-css");
        if (existing) {
            existing.remove();
        }
        const link = document.createElement("link");
        link.id = "overlay-theme-css";
        link.rel = "stylesheet";
        link.href = `overlay-theme-${themeName}.css`;
        document.head.appendChild(link);
        return new Promise((resolve) => {
            link.addEventListener("load", () => resolve(true), {once: true});
            link.addEventListener("error", () => resolve(false), {once: true});
        });
    }

    async function loadThemeCss(themeName) {
        const requestedTheme = sanitizeThemeName(themeName);
        if (requestedTheme == null) {
            console.error(`[theme] Invalid theme '${String(themeName)}'; allowed chars: a-z, 0-9, _, -. Falling back to 'xbox'.`);
            await attachThemeStylesheet("xbox");
            return;
        }

        const loadedRequestedTheme = await attachThemeStylesheet(requestedTheme);
        if (loadedRequestedTheme) {
            return;
        }

        console.error(`[theme] Could not load overlay-theme-${requestedTheme}.css; falling back to 'xbox'.`);
        const loadedFallbackTheme = await attachThemeStylesheet("xbox");
        if (!loadedFallbackTheme) {
            console.error("[theme] Could not load fallback overlay-theme-xbox.css.");
        }
    }

    function attachLayoutScript(layoutName) {
        const existing = document.getElementById("overlay-layout-script");
        if (existing) {
            existing.remove();
        }
        delete window.OverlayLayoutProfile;
        const script = document.createElement("script");
        script.id = "overlay-layout-script";
        script.src = `overlay-layout-${layoutName}.js`;
        document.head.appendChild(script);
        return new Promise((resolve) => {
            script.addEventListener("load", () => resolve(true), {once: true});
            script.addEventListener("error", () => resolve(false), {once: true});
        });
    }

    function normalizeTriggerMode(value, fallback = "analog") {
        return ["analog", "digital", "none"].includes(value) ? value : fallback;
    }

    function resolveLayoutProfile(profile) {
        const model = profile?.model ?? {};
        const controls = profile?.controls ?? {};
        const buttonLength = Math.max(1, Number(model.buttonLength) || DEFAULTS.buttonLength);
        const buttonWidth = Math.max(1, Number(model.buttonWidth) || DEFAULTS.buttonWidth);
        const gap = Number.isFinite(Number(model.gap)) ? Number(model.gap) : DEFAULTS.gap;
        const betweenHalvesGap = Number.isFinite(Number(model.betweenHalvesGap))
            ? Number(model.betweenHalvesGap)
            : DEFAULTS.betweenHalvesGap;
        const borderInnerSize = Math.max(0, Number(model.borderInnerSize) || 4);
        const borderOuterSize = Math.max(0, Number(model.borderOuterSize) || 4);
        return {
            model: {
                buttonLength,
                buttonWidth,
                gap,
                betweenHalvesGap,
                borderInnerSize,
                borderOuterSize,
            },
            controls: {
                hasAnalogStick: controls.hasAnalogStick !== false,
                leftTriggerMode: normalizeTriggerMode(controls.leftTriggerMode, "analog"),
                rightTriggerMode: normalizeTriggerMode(controls.rightTriggerMode, "analog"),
                drawLeftOriginRingWithoutStick: controls.drawLeftOriginRingWithoutStick !== false,
            },
        };
    }

    async function loadLayoutProfile(layoutName) {
        const requestedLayout = sanitizeProfileName(layoutName);
        if (requestedLayout == null) {
            console.error(`[layout] Invalid layout '${String(layoutName)}'; allowed chars: a-z, 0-9, _, -. Falling back to 'xbox'.`);
            await attachLayoutScript("xbox");
            return resolveLayoutProfile(window.OverlayLayoutProfile);
        }

        const loadedRequestedLayout = await attachLayoutScript(requestedLayout);
        if (loadedRequestedLayout) {
            return resolveLayoutProfile(window.OverlayLayoutProfile);
        }

        console.error(`[layout] Could not load overlay-layout-${requestedLayout}.js; falling back to 'xbox'.`);
        const loadedFallbackLayout = await attachLayoutScript("xbox");
        if (!loadedFallbackLayout) {
            console.error("[layout] Could not load fallback overlay-layout-xbox.js.");
        }
        return resolveLayoutProfile(window.OverlayLayoutProfile);
    }

    function createSharedModel(layoutProfile) {
        const borderWidth = layoutProfile.model.borderInnerSize + layoutProfile.model.borderOuterSize;
        return OverlaySpec.createOverlayModel({
            buttonLength: layoutProfile.model.buttonLength,
            buttonWidth: layoutProfile.model.buttonWidth,
            borderWidth,
            innerBorderSize: layoutProfile.model.borderInnerSize,
            gap: layoutProfile.model.gap,
            betweenHalvesGap: layoutProfile.model.betweenHalvesGap,
            leftTriggerMode: layoutProfile.controls.leftTriggerMode,
            rightTriggerMode: layoutProfile.controls.rightTriggerMode,
        });
    }

    async function init({svgId}) {
        const query = new URLSearchParams(window.location.search);
        const theme = (query.get("theme") || "xbox").toLowerCase();
        const layout = (query.get("layout") || "xbox").toLowerCase();
        await loadThemeCss(theme);
        OverlayTheme.applyCssDefaults(document.documentElement);
        const layoutProfile = await loadLayoutProfile(layout);
        const model = createSharedModel(layoutProfile);
        const context = new SvgContext(document.getElementById(svgId));
        const overlay = new GamepadOverlay({
            context,
            model,
            topLeft: new Vector2({
                x: DEFAULTS.topLeftX,
                y: DEFAULTS.topLeftY,
            }),
            gap: layoutProfile.model.gap,
            digitalThreshold: Math.max(0, Math.min(1, queryNumber(query, "digitalThreshold", DEFAULTS.digitalThreshold))),
            prewarmPressFillVisuals: true,
            themeVariables: {},
            hasAnalogStick: layoutProfile.controls.hasAnalogStick,
            drawLeftOriginRingWithoutStick: layoutProfile.controls.drawLeftOriginRingWithoutStick,
        });

        const overlayRegion = overlay.region;
        context.svg.setAttribute(
            "viewBox",
            `${overlayRegion.topLeft.x} ${overlayRegion.topLeft.y} ${overlay.width} ${overlay.height}`
        );
        context.svg.setAttribute("width", String(overlay.width));
        context.svg.setAttribute("height", String(overlay.height));

        const sourceStatus = {
            source: parseInputSource(query).toUpperCase(),
            pad: "WAIT",
            connected: false,
            lastUpdateMs: 0,
            selectedPadLabel: "none",
            listedPadsText: "",
        };
        const renderer = new GamepadOverlayRenderer({
            overlay,
            sourceStatus,
            deadzoneMode: "none",
            fixedDeadzone: 0,
        });
        const source = createSource({
            query,
            mode: parseInputSource(query),
            renderer,
            onStatus: (patch) => Object.assign(sourceStatus, patch),
        });
        source.start();
    }

    window.OverlayApp = Object.freeze({
        DEFAULTS,
        init,
    });
})();
