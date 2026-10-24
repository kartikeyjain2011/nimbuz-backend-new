-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "installBytes" BIGINT,
ADD COLUMN     "installDir" TEXT,
ADD COLUMN     "installed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "inventorySeenAt" TIMESTAMP(3),
ADD COLUMN     "launcher" TEXT,
ADD COLUMN     "launcherId" TEXT;

-- CreateTable
CREATE TABLE "InventoryReport" (
    "id" TEXT NOT NULL,
    "vm" TEXT NOT NULL,
    "drive" TEXT,
    "gameCount" INTEGER NOT NULL,
    "matched" INTEGER NOT NULL,
    "created" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryReport_vm_receivedAt_idx" ON "InventoryReport"("vm", "receivedAt");
