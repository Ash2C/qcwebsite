import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import Capabilities from "@/components/Capabilities";
import Audience from "@/components/Audience";
import Contact from "@/components/Contact";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-x-hidden bg-qc-ink">
      <Nav />
      <Hero />
      <Capabilities />
      <Audience />
      <Contact />
      <Footer />
    </main>
  );
}
