(() => {
    const DEFAULTS = Object.freeze({
        buttonLength: 132,
        buttonWidth: 132,
        gap: 1,
        betweenHalvesGap: 0,
        digitalThreshold: 0.55,
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

    function createSharedModel() {
        const style = getComputedStyle(document.documentElement);
        const innerBorderSize =
            Number.parseFloat(style.getPropertyValue("--overlay-border-inner-size")) || 4;
        const outerBorderSize =
            Number.parseFloat(style.getPropertyValue("--overlay-border-outer-size")) || 4;
        const borderWidth = innerBorderSize + outerBorderSize;
        return createRasterOverlayModel({
            buttonLength: DEFAULTS.buttonLength,
            buttonWidth: DEFAULTS.buttonWidth,
            borderWidth,
            innerBorderSize,
            gap: DEFAULTS.gap,
            betweenHalvesGap: DEFAULTS.betweenHalvesGap,
        });
    }

    function createSource({query, mode, renderer, onStatus = () => {}}) {
        return createGamepadSource({
            mode,
            wsUrl: `ws://${query.get("wsHost") || "localhost"}:${DEFAULTS.wsPort}/gamepad-overlay`,
            pollMs: Math.max(
                1,
                Math.round(
                    1000 /
                        Math.max(
                            1,
                            Number.parseInt(
                                query.get("poll") || String(DEFAULTS.pollHz),
                                10
                            )
                        )
                )
            ),
            padIndex:
                query.get("padIndex") == null
                    ? null
                    : Math.max(0, Number.parseInt(query.get("padIndex"), 10) || 0),
            padIdContains: (query.get("padIdContains") || "").trim(),
            padRequireStandard: query.get("padRequireStandard") === "1",
            listPads: query.get("pads") === "1" || query.get("listPads") === "1",
            onState: (state) => renderer.applyState(state),
            onStatus,
        });
    }

    function initCanvas2D({canvasId}) {
        OverlayTheme.applyCssDefaults(document.documentElement);
        const query = new URLSearchParams(window.location.search);
        const model = createSharedModel();
        const renderer = new Canvas2DGamepadOverlayRenderer({
            canvas: document.getElementById(canvasId),
            model,
            maxFps: Number.parseInt(query.get("maxFps") || "0", 10),
        });
        const source = createSource({
            query,
            mode: parseInputSource(query),
            renderer,
        });
        source.start();
    }

    function initWebGL({canvasId}) {
        OverlayTheme.applyCssDefaults(document.documentElement);
        const query = new URLSearchParams(window.location.search);
        const model = createSharedModel();
        const renderer = new WebGLGamepadOverlayRenderer({
            canvas: document.getElementById(canvasId),
            model,
            maxFps: Number.parseInt(query.get("maxFps") || "0", 10),
            debugPerf: query.get("debugPerf") === "1",
            alphaScale: Number.parseFloat(query.get("alphaScale") || "1"),
            outputGamma: Number.parseFloat(query.get("outputGamma") || "1.45"),
        });
        const source = createSource({
            query,
            mode: parseInputSource(query),
            renderer,
        });
        source.start();
    }

    function initSvg({svgId}) {
        OverlayTheme.applyCssDefaults(document.documentElement);
        const query = new URLSearchParams(window.location.search);
        const model = createSharedModel();
        const context = new SvgContext(document.getElementById(svgId));
        const theme = (query.get("theme") || "xbox").toLowerCase();
        const overlay = new GamepadOverlay({
            context,
            model,
            buttonLength: DEFAULTS.buttonLength,
            buttonWidth: DEFAULTS.buttonWidth,
            topLeft: new Vector2({x: 0, y: 0}),
            gap: DEFAULTS.gap,
            betweenHalvesGap: DEFAULTS.betweenHalvesGap,
            digitalThreshold: DEFAULTS.digitalThreshold,
            digitalRenderMode:
                query.get("digitalRenderMode") === "class"
                    ? "class-toggle"
                    : "fill",
            prewarmPressFillVisuals: query.get("prewarmPressVisuals") !== "0",
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

    window.OverlayBootstrap = Object.freeze({
        DEFAULTS,
        initCanvas2D,
        initWebGL,
        initSvg,
    });
})();
