using System.Diagnostics;
using System.Numerics;
using NUnit.Framework;

// Port of the headless pace test (handoff section 9). Windows come from 20 runs of the web FireSim
// at commit b78c0c4: floor and desk swing widely because burning bits drop at random.
public class FirePaceTests
{
    const int Floor = 0, WallXPlus = 4, Table = 5, Couch = 6, Desk = 7;

    [TestCase(1)]
    [TestCase(2)]
    [TestCase(3)]
    public void ReferenceRoomBurnsOnTheWebTimeline(int seed)
    {
        var t = ReferenceRoom.FirstIgnitions(seed, out _);
        // object order: floor, 4 walls (z-, z+, x-, x+), table, couch, desk (the ceiling isn't fuel)
        Assert.AreEqual(0.1f, t[Table], 0.05f, "table");
        Assert.That(t[Floor], Is.InRange(5f, 50f), "floor");
        Assert.That(t[Couch], Is.InRange(33f, 43f), "couch");
        Assert.That(t[WallXPlus], Is.InRange(80f, 93f), "first wall (x+)");
        Assert.That(t[Desk], Is.InRange(105f, 155f), "desk");
    }

    [Test]
    public void TableFullyAlightAround20s()
    {
        var sim = new FireSim(ReferenceRoom.Surfaces(), 1);
        sim.Ignite(ReferenceRoom.IgnitePoint);
        float full = -1;
        for (int k = 1; k <= 400 && full < 0; k++)
        {
            sim.Tick(FireSim.TICK, true);
            if (sim.GetObjectStatus()[Table].Burnt >= 0.999f) full = k * FireSim.TICK;
        }
        Assert.That(full, Is.InRange(15f, 25f));
    }

    [Test]
    public void CellsNearOpenExitNeverIgnite()
    {
        ReferenceRoom.FirstIgnitions(4, out var sim);
        int prot = 0;
        for (int i = 0; i < sim.N; i++)
        {
            float dx = sim.Fuel.X[i] - ReferenceRoom.OpenExit.X, dz = sim.Fuel.Z[i] - ReferenceRoom.OpenExit.Y;
            if (dx * dx + dz * dz >= 1.5f * 1.5f) continue;
            prot++;
            Assert.AreEqual(0, sim.State[i], $"cell {i} by the exit burned");
        }
        Assert.Greater(prot, 0);
    }

    [Test]
    public void BeforeTheDrillAClickMakesASmallClusterThatHolds()
    {
        var sim = new FireSim(ReferenceRoom.Surfaces(), 1);
        sim.Ignite(ReferenceRoom.IgnitePoint);
        Assert.That(sim.Burning.Count, Is.InRange(2, 3));
        for (int k = 0; k < 600; k++) sim.Tick(FireSim.TICK, false);
        Assert.That(sim.Burning.Count, Is.InRange(2, 3));
        foreach (int i in sim.Burning) Assert.LessOrEqual(sim.Burn[i], FireSim.IDLE_BURN + 1e-4f);
    }

    [Test]
    public void IgnitingAwayFromFuelMakesAPileAndKeepsState()
    {
        var sim = new FireSim(ReferenceRoom.Surfaces(), 1);
        sim.Ignite(ReferenceRoom.IgnitePoint);
        for (int k = 0; k < 50; k++) sim.Tick(FireSim.TICK, true);
        int before = sim.Burning.Count;
        int cell = sim.Ignite(new Vector3(0, 1.5f, 1.5f)); // mid-air: no fuel within 0.6 m
        Assert.GreaterOrEqual(cell, 0);
        Assert.AreEqual("fire", sim.Fuel.Objects[sim.Fuel.Objects.Count - 1].Label);
        Assert.Greater(sim.Burning.Count, before);
    }

    [Test]
    public void TickOf900CellsIsUnder1ms()
    {
        ReferenceRoom.FirstIgnitions(5, out var sim, 900); // room well alight
        var sw = Stopwatch.StartNew();
        for (int k = 0; k < 100; k++) sim.Tick(FireSim.TICK, true);
        Assert.Less(sw.Elapsed.TotalMilliseconds / 100, 1.0);
    }
}
