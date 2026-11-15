(() => {
  const landingNav = document.querySelector(".landing-nav");
  const menuTriggers = Array.from(landingNav?.querySelectorAll(".landing-nav-trigger") || []);
  const closeMenus = () => {
    menuTriggers.forEach((trigger) => {
      trigger.setAttribute("aria-expanded", "false");
      const menu = document.getElementById(trigger.getAttribute("aria-controls"));
      if (menu) menu.hidden = true;
    });
  };

  menuTriggers.forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const menu = document.getElementById(trigger.getAttribute("aria-controls"));
      const shouldOpen = menu?.hidden;
      closeMenus();
      if (menu && shouldOpen) {
        menu.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
      }
    });

    trigger.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const menu = document.getElementById(trigger.getAttribute("aria-controls"));
      if (!menu) return;
      if (menu.hidden) trigger.click();
      const items = Array.from(menu.querySelectorAll("a, button:not(:disabled)"));
      items[event.key === "ArrowUp" ? items.length - 1 : 0]?.focus();
    });
  });

  landingNav?.addEventListener("click", (event) => {
    if (event.target.closest(".landing-dropdown a")) closeMenus();
  });

  document.addEventListener("click", (event) => {
    if (landingNav && !landingNav.contains(event.target)) closeMenus();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const openTrigger = menuTriggers.find((trigger) => trigger.getAttribute("aria-expanded") === "true");
    if (!openTrigger) return;
    closeMenus();
    openTrigger.focus();
  });

  const progressBar = document.querySelector(".landing-scroll-progress span");
  let progressUpdateScheduled = false;
  const updateProgress = () => {
    if (!progressBar) return;
    const page = document.documentElement;
    const distance = page.scrollHeight - window.innerHeight;
    const progress = distance > 0 ? Math.min(1, Math.max(0, window.scrollY / distance)) : 0;
    progressBar.style.transform = `scaleX(${progress})`;
    progressUpdateScheduled = false;
  };
  window.addEventListener("scroll", () => {
    if (progressUpdateScheduled) return;
    progressUpdateScheduled = true;
    window.requestAnimationFrame(updateProgress);
  }, { passive: true });
  window.addEventListener("resize", updateProgress, { passive: true });
  updateProgress();

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || !("IntersectionObserver" in window)) return;

  const revealItems = Array.from(document.querySelectorAll(".scroll-reveal"));
  if (!revealItems.length) return;

  revealItems.forEach((item, index) => {
    item.style.setProperty("--reveal-delay", `${(index % 3) * 100}ms`);
  });
  document.documentElement.classList.add("motion-ready");

  const observer = new IntersectionObserver((entries, currentObserver) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      currentObserver.unobserve(entry.target);
    });
  }, {
    threshold: 0.12,
    rootMargin: "0px 0px -6% 0px",
  });

  revealItems.forEach((item) => observer.observe(item));
})();
