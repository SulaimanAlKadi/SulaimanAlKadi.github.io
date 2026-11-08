/* Email addresses are kept out of the page source, so address-harvesting bots that read HTML do not
   find them; this script assembles them in the browser. data-email holds "user|domain", each written
   backwards. A .email-reveal block shows "Show email" until it is hovered, focused or tapped; any other
   element with data-email just gets a mailto: link (with data-subject as the subject, if given). */
(() => {
  "use strict";
  const rev = s => s.split("").reverse().join("");
  for (const el of document.querySelectorAll("[data-email]")) {
    const [u, d] = el.dataset.email.split("|").map(rev);
    const addr = u + "@" + d;
    const subject = el.dataset.subject ? "?subject=" + encodeURIComponent(el.dataset.subject) : "";
    if (el.classList.contains("email-reveal")) {
      const a = el.querySelector(".addr");
      a.textContent = addr;
      a.href = "mailto:" + addr;
      // touch screens have no hover: the first tap reveals, the next tap on the address opens mail
      el.addEventListener("click", e => {
        if (!el.classList.contains("open")) { e.preventDefault(); el.classList.add("open"); }
      });
      el.addEventListener("mouseleave", () => el.classList.remove("open"));
      el.addEventListener("focusout", e => { if (!el.contains(e.relatedTarget)) el.classList.remove("open"); });
    } else {
      el.href = "mailto:" + addr + subject;
    }
  }
})();
