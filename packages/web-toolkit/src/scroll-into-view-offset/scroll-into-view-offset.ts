export const scrollIntoViewWithOffset = (element: HTMLElement, offset: number) => {
  window.scrollTo({
    behavior: 'smooth',
    top: element.getBoundingClientRect().top - document.body.getBoundingClientRect().top - offset,
  })
}
