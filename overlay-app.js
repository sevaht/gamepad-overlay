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

    function resolveLayoutConfig() {
        return {
            buttonLength: DEFAULTS.buttonLength,
            buttonWidth: DEFAULTS.buttonWidth,
            gap: DEFAULTS.gap,
            betweenHalvesGap: DEFAULTS.betweenHalvesGap,
        };
    }

    function createSharedModel(layout) {
        const style = getComputedStyle(document.documentElement);
        const innerBorderSize = Number.isFinite(layout.innerBorderSize)
            ? layout.innerBorderSize
            : (Number.parseFloat(style.getPropertyValue("--overlay-border-inner-size")) || 4);
        const outerBorderSize = Number.isFinite(layout.outerBorderSize)
            ? layout.outerBorderSize
            : (Number.parseFloat(style.getPropertyValue("--overlay-border-outer-size")) || 4);
        const borderWidth = innerBorderSize + outerBorderSize;
        return OverlaySpec.createOverlayModel({
            buttonLength: layout.buttonLength,
            buttonWidth: layout.buttonWidth,
            borderWidth,
            innerBorderSize,
            gap: layout.gap,
            betweenHalvesGap: layout.betweenHalvesGap,
        });
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

    function init({svgId}) {
        OverlayTheme.applyCssDefaults(document.documentElement);
        const query = new URLSearchParams(window.location.search);
        const layout = resolveLayoutConfig();
        const model = createSharedModel(layout);
        const context = new SvgContext(document.getElementById(svgId));
        const theme = (query.get("theme") || "xbox").toLowerCase();
        const overlay = new GamepadOverlay({
            context,
            model,
            topLeft: new Vector2({
                x: DEFAULTS.topLeftX,
                y: DEFAULTS.topLeftY,
            }),
            gap: layout.gap,
            digitalThreshold: Math.max(0, Math.min(1, queryNumber(query, "digitalThreshold", DEFAULTS.digitalThreshold))),
            prewarmPressFillVisuals: true,
            themeVariables:
                OverlayTheme.THEME_PRESETS[theme] || OverlayTheme.THEME_PRESETS.xbox,
            hasAnalogStick: true,
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
