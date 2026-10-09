(() => {
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
