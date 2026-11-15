(function (global) {
  "use strict";

  function exportName(name) {
    return String(name)
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
  }

  function create(name, options = {}) {
    const icon = global.lucide?.[exportName(name)];
    if (!icon || typeof global.lucide?.createElement !== "function") {
      throw new Error(`Unknown Lucide icon: ${name}`);
    }

    const size = Number(options.size) || 20;
    const label = options.label ? String(options.label) : "";
    const attrs = {
      width: size,
      height: size,
      "stroke-width": options.strokeWidth ?? 1.9,
      class: options.className || "beabots-icon",
      focusable: "false",
      "aria-hidden": label ? "false" : "true",
    };

    if (label) {
      attrs.role = "img";
      attrs["aria-label"] = label;
    }

    return global.lucide.createElement(icon, attrs);
  }

  function replace(target, name, options = {}) {
    if (!(target instanceof Element)) throw new TypeError("A target element is required.");
    const svg = create(name, options);
    target.replaceWith(svg);
    return svg;
  }

  function hydrate(root = document) {
    root.querySelectorAll("[data-lucide]").forEach((target) => {
      try {
        const svg = create(target.dataset.lucide, {
          size: Number(target.dataset.iconSize) || 20,
          strokeWidth: Number(target.dataset.strokeWidth) || 1.9,
          className: target.className || "beabots-icon",
          label: target.dataset.iconLabel || "",
        });
        target.replaceWith(svg);
      } catch (error) {
        console.error(error);
      }
    });
  }

  global.BeabotsIcons = Object.freeze({ create, replace, hydrate });
})(window);
