(() => {
  const notice = document.getElementById("cookieNotice");
  const status = document.getElementById("cookieStatus");
  const choiceName = "pumpfiat_cookie_choice";

  document.querySelectorAll(".site-mobile-nav").forEach((menu) => {
    const summary = menu.querySelector("summary");
    menu.addEventListener("toggle", () => summary?.setAttribute("aria-expanded", String(menu.open)));
  });

  document.querySelectorAll("[data-current-year]").forEach((element) => {
    element.textContent = String(new Date().getFullYear());
  });

  function getCookie(name) {
    const prefix = `${name}=`;
    const value = document.cookie.split("; ").find((cookie) => cookie.startsWith(prefix));
    return value ? decodeURIComponent(value.slice(prefix.length)) : "";
  }

  function setChoice(value) {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${choiceName}=${value}; Max-Age=15552000; Path=/; SameSite=Lax${secure}`;
  }

  async function updateReferralCookie(value) {
    const referralCode = new URLSearchParams(location.search).get("ref") || "";
    if (value === "accept" && !referralCode) return;

    const response = await fetch("/api/registration/referral", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referralCode }),
    });
    if (!response.ok) throw new Error("We couldn't update referral cookie settings.");
  }

  if (notice && !getCookie(choiceName)) notice.hidden = false;

  notice?.querySelectorAll("[data-cookie-choice]").forEach((button) => {
    button.addEventListener("click", async () => {
      const value = button.dataset.cookieChoice;
      setChoice(value);
      notice.hidden = true;

      try {
        await updateReferralCookie(value);
      } catch (error) {
        if (status) {
          status.textContent = error instanceof Error ? error.message : "We couldn't update referral cookie settings.";
          notice.hidden = false;
        }
      }
    });
  });
})();
